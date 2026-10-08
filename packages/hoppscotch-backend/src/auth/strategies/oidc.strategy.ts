import { Strategy } from 'passport-microsoft';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthService } from '../auth.service';
import { UserService } from 'src/user/user.service';
import * as O from 'fp-ts/Option';
import * as E from 'fp-ts/Either';
import { ConfigService } from '@nestjs/config';
import { validateEmail } from 'src/utils';
import { AUTH_EMAIL_NOT_PROVIDED_BY_OAUTH } from 'src/errors';
import { StatelessStateStore } from '../stateless-state-store';

/**
 * [wasl] 범용 OAuth2 로그인 (OCI IAM Identity Domain 등).
 * passport-microsoft 는 passport-oauth2 위에서 authorize · token URL 을 옵션으로 받는다. 그 두 URL 을 공급자 것으로 주고
 * 프로필 조회(Microsoft Graph)만 공급자의 userinfo 로 바꿔, 새 의존성 없이 일반 OAuth2 로 쓴다.
 * OIDC discovery 는 쓰지 않는다 - OCI Identity Domain 은 discovery 의 issuer 가 도메인 URL 이 아니라 공통값이다.
 */
@Injectable()
export class OidcStrategy extends PassportStrategy(Strategy, 'oidc') {
  private readonly userInfoURL: string;

  constructor(
    private authService: AuthService,
    private usersService: UserService,
    private configService: ConfigService,
  ) {
    super({
      clientID: configService.get<string>('INFRA.OIDC_CLIENT_ID'),
      clientSecret: configService.get<string>('INFRA.OIDC_CLIENT_SECRET'),
      callbackURL: configService.get<string>('INFRA.OIDC_CALLBACK_URL'),
      authorizationURL: configService.get<string>('INFRA.OIDC_AUTH_URL'),
      tokenURL: configService.get<string>('INFRA.OIDC_TOKEN_URL'),
      scope: configService.get<string>('INFRA.OIDC_SCOPE').split(','),
      store: new StatelessStateStore(
        configService.get<string>('INFRA.SESSION_SECRET'),
        undefined,
        (configService.get<string>('INFRA.SESSION_COOKIE_NAME') ||
          '__oauth_nonce') + '_oidc',
        configService.get<string>('INFRA.ALLOW_SECURE_COOKIES') === 'true',
      ),
    });
    // passport-microsoft 가 이름을 'microsoft' 로 덮는다. 등록 이름(PassportStrategy 두 번째 인자)과 맞춘다.
    this.name = 'oidc';
    this.userInfoURL = configService.get<string>('INFRA.OIDC_USERINFO_URL');
  }

  /**
   * Microsoft Graph 대신 공급자의 userinfo 를 읽어 passport 프로필 모양으로 바꾼다.
   * 이메일은 email · preferred_username · sub 중 이메일 형식인 첫 값이다(Identity Domain 은 사용자 이름이 이메일이다).
   */
  userProfile(
    accessToken: string,
    done: (err?: unknown, profile?: unknown) => void,
  ) {
    this._oauth2.useAuthorizationHeaderforGET(true);
    this._oauth2.get(this.userInfoURL, accessToken, (err, body) => {
      if (err) return done(new Error('failed to fetch user info'));
      try {
        done(null, toProfile(JSON.parse(String(body))));
      } catch (e) {
        done(e);
      }
    });
  }

  async validate(accessToken: string, refreshToken: string, profile, done) {
    const email = profile?.emails?.[0]?.value;

    if (!validateEmail(email))
      throw new UnauthorizedException(AUTH_EMAIL_NOT_PROVIDED_BY_OAUTH);

    const user = await this.usersService.findUserByEmail(email);

    if (O.isNone(user)) {
      const createdUser = await this.usersService.createUserSSO(
        accessToken,
        refreshToken,
        profile,
      );
      return createdUser;
    }

    /**
     * displayName and photoURL maybe null if user logged-in via magic-link before SSO
     */
    if (!user.value.displayName || !user.value.photoURL) {
      const updatedUser = await this.usersService.updateUserDetails(
        user.value,
        profile,
      );
      if (E.isLeft(updatedUser)) {
        throw new UnauthorizedException(updatedUser.left);
      }
    }

    const providerAccountExists =
      await this.authService.checkIfProviderAccountExists(user.value, profile);

    if (O.isNone(providerAccountExists))
      await this.usersService.createProviderAccount(
        user.value,
        accessToken,
        refreshToken,
        profile,
      );

    return user.value;
  }
}

/**
 * userinfo 응답을 passport 프로필로. 이메일이 없으면 emails 를 비워 validate 가 AUTH_EMAIL_NOT_PROVIDED_BY_OAUTH 로 거부한다.
 */
export function toProfile(info: Record<string, unknown>) {
  const email = [info.email, info.preferred_username, info.sub].find(
    (v): v is string => typeof v === 'string' && validateEmail(v),
  );
  return {
    provider: 'oidc',
    id: String(info.sub),
    displayName: typeof info.name === 'string' ? info.name : null,
    emails: email ? [{ value: email }] : [],
    _json: info,
  };
}
