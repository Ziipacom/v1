from contextlib import asynccontextmanager
from datetime import datetime, timezone
import hashlib
from pathlib import Path
import secrets

from fastapi import FastAPI, Depends, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, EmailStr, Field
from pydantic_settings import BaseSettings, SettingsConfigDict
from pwdlib import PasswordHash
from redis import Redis
from redis.exceptions import RedisError
from sqlalchemy import create_engine, String, DateTime, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker, Session


class Settings(BaseSettings):
    database_url: str = 'postgresql+psycopg://ziipa:ziipa_local@127.0.0.1:55439/ziipa'
    redis_url: str = 'redis://127.0.0.1:56389/0'
    frontend_origin: str = 'http://localhost:5178'
    mobile_web_origin: str = 'http://localhost:8082'
    uploads_dir: str = str(Path(__file__).resolve().parent / 'uploads')
    secure_cookies: bool = False
    moderator_emails: str = ''
    enable_demo_catalog: bool = True
    social_bluesky_client_id: str = ''
    social_facebook_client_id: str = ''
    social_instagram_client_id: str = ''
    social_tiktok_client_id: str = ''
    social_twitch_client_id: str = ''
    social_youtube_client_id: str = ''
    model_config = SettingsConfigDict(env_file='.env', extra='ignore')


settings = Settings()


def configured_origins():
    return tuple(
        origin.strip().rstrip('/')
        for value in (settings.frontend_origin, settings.mobile_web_origin)
        for origin in value.split(',')
        if origin.strip()
    )


TRUSTED_ORIGINS = configured_origins()


def sqlalchemy_database_url(value: str):
    # Render provides a standard postgresql:// URL. Select the installed
    # psycopg v3 driver explicitly instead of falling back to psycopg2.
    if value.startswith('postgresql://'):
        return 'postgresql+psycopg://' + value.removeprefix('postgresql://')
    return value


engine = create_engine(sqlalchemy_database_url(settings.database_url), pool_pre_ping=True)
SessionLocal = sessionmaker(engine)
cache = Redis.from_url(settings.redis_url, decode_responses=True, socket_connect_timeout=2, socket_timeout=2)
passwords = PasswordHash.recommended()
DUMMY_HASH = passwords.hash(secrets.token_urlsafe(32))


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = 'users'
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    email: Mapped[str] = mapped_column(String(320), unique=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class Waitlist(Base):
    __tablename__ = 'waitlist'
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    email: Mapped[str] = mapped_column(String(320), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


@asynccontextmanager
async def lifespan(app):
    Base.metadata.create_all(engine)  # Local bootstrap; use migrations before production.
    yield
    cache.close()
    engine.dispose()


app = FastAPI(title='Ziipa API', version='0.1.0', lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=list(TRUSTED_ORIGINS), allow_credentials=True, allow_methods=['GET', 'POST'], allow_headers=['Content-Type', 'Authorization'])


@app.middleware('http')
async def private_api_responses(request: Request, call_next):
    response = await call_next(request)
    response.headers['Cache-Control'] = 'private, no-store'
    response.headers['X-Content-Type-Options'] = 'nosniff'
    return response


def db():
    with SessionLocal() as session:
        yield session


def guard(request: Request):
    origin = request.headers.get('origin', '').rstrip('/')
    if origin and origin not in TRUSTED_ORIGINS:
        raise HTTPException(403, 'Untrusted origin')
    ip = request.client.host if request.client else 'unknown'
    key = 'rate:' + hashlib.sha256((ip + request.url.path).encode()).hexdigest()
    try:
        count = cache.eval("local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n", 1, key)
        if count > 15:
            raise HTTPException(429, 'Too many attempts. Please wait a minute.')
    except RedisError:
        raise HTTPException(503, 'Session service unavailable. Please try again.')


def current_user(request: Request, session: Session = Depends(db)):
    authorization = request.headers.get('authorization')
    prefix = 'session:'
    if authorization is not None:
        scheme, _, token = authorization.partition(' ')
        if scheme.lower() != 'bearer' or not token or len(token) > 256:
            raise HTTPException(401, 'Invalid mobile session')
        prefix = 'mobile_session:'
    else:
        token = request.cookies.get('ziipa_session', '')
    if not token:
        raise HTTPException(401, 'Please sign in')
    try:
        uid = cache.get(prefix + hashlib.sha256(token.encode()).hexdigest())
    except RedisError:
        raise HTTPException(503, 'Session service unavailable')
    user = session.get(User, int(uid)) if uid else None
    if not user:
        raise HTTPException(401, 'Please sign in')
    return user


def start_session(user, response):
    token = secrets.token_urlsafe(32)
    try:
        cache.setex('session:' + hashlib.sha256(token.encode()).hexdigest(), 86400, str(user.id))
    except RedisError:
        raise HTTPException(503, 'Account saved, but sign-in is unavailable. Please try signing in later.')
    response.set_cookie('ziipa_session', token, httponly=True, secure=settings.secure_cookies, samesite='lax', max_age=86400, path='/')


class Join(BaseModel):
    name: str = Field(min_length=1, max_length=100, pattern=r'.*\S.*')
    email: EmailStr


class Register(Join):
    password: str = Field(min_length=12, max_length=128)


class Login(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)


@app.get('/api/health')
def health(response: Response):
    services = {}
    try:
        with engine.connect() as connection:
            connection.execute(text('SELECT 1'))
        services['database'] = 'connected'
    except Exception:
        services['database'] = 'unavailable'
    try:
        cache.ping()
        services['redis'] = 'connected'
    except RedisError:
        services['redis'] = 'unavailable'
    if 'unavailable' in services.values():
        response.status_code = 503
    return services


@app.post('/api/waitlist', dependencies=[Depends(guard)])
def join(data: Join, session: Session = Depends(db)):
    session.add(Waitlist(name=data.name.strip(), email=str(data.email).lower()))
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
    return {'message': "You're on the list. Thanks for being part of what comes next."}


@app.post('/api/auth/register', status_code=201, dependencies=[Depends(guard)])
def register(data: Register, response: Response, session: Session = Depends(db)):
    user = User(name=data.name.strip(), email=str(data.email).lower(), password_hash=passwords.hash(data.password))
    session.add(user)
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        raise HTTPException(409, 'Unable to create an account with these details. Try signing in.')
    session.refresh(user)
    start_session(user, response)
    return {'name': user.name, 'email': user.email}


@app.post('/api/auth/login', dependencies=[Depends(guard)])
def login(data: Login, response: Response, session: Session = Depends(db)):
    user = session.scalar(select(User).where(User.email == str(data.email).lower()))
    valid = passwords.verify(data.password, user.password_hash if user else DUMMY_HASH)
    if not user or not valid:
        raise HTTPException(401, 'Email or password is incorrect')
    start_session(user, response)
    return {'name': user.name, 'email': user.email}


@app.post('/api/auth/logout', dependencies=[Depends(guard)])
def logout(request: Request, response: Response):
    token = request.cookies.get('ziipa_session', '')
    try:
        cache.delete('session:' + hashlib.sha256(token.encode()).hexdigest())
    except RedisError:
        raise HTTPException(503, 'Unable to end session. Please try again.')
    response.delete_cookie('ziipa_session', path='/')
    return {'ok': True}


@app.get('/api/me')
def me(user: User = Depends(current_user)):
    return {'id': user.id, 'name': user.name, 'email': user.email, 'joined': user.created_at.isoformat(), 'membership': 'Early explorer', 'is_moderator': user.email in {e.strip().lower() for e in settings.moderator_emails.split(',') if e.strip()}}


from creator import router as creator_router
app.include_router(creator_router)
from mobile_api import router as mobile_router
app.include_router(mobile_router)
from web3_api import router as web3_router
app.include_router(web3_router)
