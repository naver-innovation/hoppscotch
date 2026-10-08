import { OidcStrategy, toProfile } from './oidc.strategy';

// [wasl] 범용 OAuth2 로그인 - passport-microsoft 를 일반 OAuth2 로 쓰는 전제와 userinfo 매핑
const config: Record<string, string> = {
  'INFRA.OIDC_CLIENT_ID': 'cid',
  'INFRA.OIDC_CLIENT_SECRET': 'secret',
  'INFRA.OIDC_CALLBACK_URL':
    'https://hopp.example/backend/v1/auth/oidc/callback',
  'INFRA.OIDC_SCOPE': 'openid,email,profile',
  'INFRA.OIDC_AUTH_URL': 'https://idcs.example/oauth2/v1/authorize',
  'INFRA.OIDC_TOKEN_URL': 'https://idcs.example/oauth2/v1/token',
  'INFRA.OIDC_USERINFO_URL': 'https://idcs.example/oauth2/v1/userinfo',
  'INFRA.SESSION_SECRET': 's'.repeat(32),
};
const configService = { get: (k: string) => config[k] };

const newStrategy = () =>
  new OidcStrategy({} as any, {} as any, configService as any) as any;

describe('OidcStrategy', () => {
  test('uses the configured provider endpoints, not Microsoft', () => {
    const s = newStrategy();
    expect(s.name).toBe('oidc');
    expect(s._oauth2._authorizeUrl).toBe(config['INFRA.OIDC_AUTH_URL']);
    expect(s._oauth2._accessTokenUrl).toBe(config['INFRA.OIDC_TOKEN_URL']);
    expect(s._scope).toEqual(['openid', 'email', 'profile']);
  });

  test('userProfile reads the provider userinfo with a bearer header', (done) => {
    const s = newStrategy();
    let calledUrl = '';
    s._oauth2.get = (url: string, token: string, cb: Function) => {
      calledUrl = url;
      expect(s._oauth2._useAuthorizationHeaderForGET).toBe(true);
      cb(null, JSON.stringify({ sub: 'dev@example.com', name: 'Dev' }));
    };
    s.userProfile('tok', (err: unknown, profile: any) => {
      expect(err).toBeNull();
      expect(calledUrl).toBe(config['INFRA.OIDC_USERINFO_URL']);
      expect(profile.emails).toEqual([{ value: 'dev@example.com' }]);
      expect(profile.provider).toBe('oidc');
      done();
    });
  });

  test('userProfile fails when userinfo fails', (done) => {
    const s = newStrategy();
    s._oauth2.get = (_u: string, _t: string, cb: Function) =>
      cb({ statusCode: 401 });
    s.userProfile('tok', (err: unknown) => {
      expect(err).toBeInstanceOf(Error);
      done();
    });
  });
});

describe('toProfile', () => {
  test('prefers the email claim', () => {
    const p = toProfile({ sub: 'u-1', email: 'a@example.com', name: 'A' });
    expect(p).toMatchObject({
      id: 'u-1',
      displayName: 'A',
      emails: [{ value: 'a@example.com' }],
    });
  });

  test('falls back to an email-shaped sub (OCI Identity Domain user name)', () => {
    expect(toProfile({ sub: 'b@example.com' }).emails).toEqual([
      { value: 'b@example.com' },
    ]);
  });

  test('leaves emails empty when no claim is an email (validate rejects it)', () => {
    const p = toProfile({ sub: '7c9e6679-7425-40de-944b-e07fc1f90ae7' });
    expect(p.emails).toEqual([]);
    expect(p.displayName).toBeNull();
  });
});
