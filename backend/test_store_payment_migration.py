"""Exercise the Store upgrade from the already-deployed Live schema, offline."""
import uuid

from alembic import command
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, inspect
from sqlalchemy.orm import Session

from app import Base, User
from live_api import LiveStream
from live_networks import NetworkDestination
from marketplace_payments import MarketOrder, SellerPaymentAccount
from marketplace_paypal import PayPalSellerAccount
import render_migrate as migration


def test_store_migration_follows_immutable_deployed_live_revision():
    scripts = ScriptDirectory.from_config(migration.migration_config())
    assert scripts.get_heads() == ['20261125_0019']
    assert scripts.get_revision('20261123_0018').down_revision == '20261030_0016'
    assert scripts.get_revision('20261125_0019').down_revision == '20261123_0018'


def test_existing_live_database_adds_store_tables_and_preserves_receipts():
    engine = create_engine('sqlite://')
    payment_tables = {model.__tablename__ for model in
                      (SellerPaymentAccount, PayPalSellerAccount, MarketOrder)}
    try:
        # Model a deployed 0018 database, which has no local-only Store tables.
        # The initial migration imports current metadata, so upgrading an empty
        # DB to an old number would incorrectly include these new tables.
        Base.metadata.create_all(engine, tables=[table for table in Base.metadata.sorted_tables
                                                if table.name not in payment_tables])
        configuration = migration.migration_config()
        with engine.begin() as connection:
            configuration.attributes['connection'] = connection
            command.stamp(configuration, '20261123_0018')
        assert not payment_tables.intersection(inspect(engine).get_table_names())

        with Session(engine) as session:
            owner = User(name='Migration fixture', email='migration@example.test', password_hash='unused')
            session.add(owner)
            session.flush()
            stream = LiveStream(owner_id=owner.id, request_id=str(uuid.uuid4()), title='Owned broadcast',
                                provider_id=str(uuid.uuid4()), status='prepared')
            session.add(stream)
            session.flush()
            destination = NetworkDestination(stream_id=stream.id, provider='youtube', owner_id=owner.id,
                                             phase='selected', channel_id='owned-channel')
            session.add(destination)
            owner_id, stream_id = owner.id, stream.id
            session.commit()

        migration.upgrade_database(engine)
        migration.ensure_schema_ready(engine)
        assert payment_tables.issubset(inspect(engine).get_table_names())
        with Session(engine) as session:
            assert session.get(LiveStream, stream_id).title == 'Owned broadcast'
            destination = session.get(NetworkDestination, (stream_id, 'youtube'))
            assert (destination.owner_id, destination.phase, destination.channel_id) == (
                owner_id, 'selected', 'owned-channel')
            session.add(SellerPaymentAccount(owner_id=owner_id, account_id='acct_synthetic'))
            session.commit()

        migration.upgrade_database(engine)
        migration.ensure_schema_ready(engine)
        with Session(engine) as session:
            assert session.get(SellerPaymentAccount, owner_id).account_id == 'acct_synthetic'
            assert session.get(NetworkDestination, (stream_id, 'youtube')).phase == 'selected'
    finally:
        engine.dispose()
