/** The SSO core, plus the one call the routes need that sits in the identity core. */
export { newAuthCode, checkAuthCode, buildReturnUrl, isAllowedReturn, isAudience, hashAuthCode } from '../../../api/_sso.ts';
import { mintSessionToken } from '../../../api/_identity.ts';

/** A session for a subject at one property. Null when no signing secret is set. */
export const mintTokenForSubject = (subject, audience, now) => mintSessionToken(subject, audience, now);
