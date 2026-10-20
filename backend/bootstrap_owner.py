"""Explicit existing-account owner bootstrap. Dry-run unless --apply is present."""
import argparse
import json


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--user-id', type=int, required=True)
    parser.add_argument('--email', required=True)
    parser.add_argument('--reason', required=True)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--allow-production', action='store_true')
    args = parser.parse_args(argv)
    if args.user_id < 1 or len(args.email) > 320:
        parser.error('Provide an exact existing account ID and email.')
    import app
    from admin_services import bootstrap_owner
    try:
        with app.SessionLocal() as session:
            result = bootstrap_owner(session, user_id=args.user_id, email=args.email,
                reason=args.reason, apply=args.apply, allow_production=args.allow_production,
                environment=app.settings.environment)
            if args.apply:
                session.commit()
            else:
                session.rollback()
        print(json.dumps(result, sort_keys=True))
        return 0
    except Exception:
        # Database URLs, connection details and password hashes never enter CLI
        # diagnostics. Operators can inspect the identity and migration state.
        print(json.dumps({'ok': False, 'detail': 'Owner bootstrap refused. Check exact identity, current owner, migration and explicit production approval.'}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
