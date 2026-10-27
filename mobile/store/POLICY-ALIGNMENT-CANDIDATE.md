# Unpublished policy and registration alignment candidate

Prepared 2026-10-27. This is an engineering proposal for owner review, not a
published policy, completed age-assurance system or store declaration.
No new audience is activated and no existing consent receipt is rewritten.

## Confirmed identity and intended audience

- Legal operator: Niche Labs LLC.
- Public support/privacy contact: ziipaziipa@gmail.com.
- Apple Team: L6WH6BD2N5; registered production bundle: com.ziipa.app.
- App Store Connect app: 6827668999; beta metadata saved, no build uploaded by
  this candidate.
- Owner's intended audience: worldwide 13+, subject to any higher applicable
  minimum age and guardian requirements. This intent does not establish that
  regional requirements or safety/consent operations have been implemented.

Full privacy, terms and community policies still need owner review and
publication. `EXPO_PUBLIC_PRIVACY_URL`, `EXPO_PUBLIC_TERMS_URL` and
`EXPO_PUBLIC_COMMUNITY_URL` remain empty by default. Public `/network-imports`
describes one factual feature; it is not a replacement for those policies.

## Current consent contract must remain truthful

`backend/mobile_api.py` defines `NativeRegister` with
`accepted_policies:Literal[True]`, `adult_confirmed:Literal[True]` and
`policy_version:Literal['2026-08-31']`. Shared Android/iOS/Studio registration in
`mobile/src/screens/auth.tsx` explicitly says 18+; `mobile/src/provider.tsx` sends
that adult declaration. The stored `mobile_policy_acceptances` row contains
only a policy version and acceptance time, not a separate age-assurance proof.
Its historical meaning must not be silently changed.

The separate legacy web portal in `frontend/app/portal/page.tsx` uses
`POST /api/auth/register`, whose current `Register` model has no age/policy
acceptance contract. This is a distinct alignment gap. Changing only the
shared Studio checkbox would neither fix it nor make a 13-year-old an adult.

This candidate keeps the deployed 18+ copy and native registration payload
unchanged. In particular, do not send `adult_confirmed:true` for an intended
minor, reuse the old policy version with a new meaning, or automatically
reinterpret existing account receipts.

## Bounded additive API proposal — not implemented

1. Publish reviewed, versioned eligibility and policy text before activating
   a new audience. Resolve territories, higher local thresholds, guardian
   permissions and youth safety operations; self-attestation alone must not be
   represented as identity verification or verified parental consent.
2. Add a first-party registration-requirements response advertising an explicit
   supported contract version, effective policy version and eligible flow.
   Until that response explicitly supports the reviewed new contract, clients
   keep the adult flow or explain that new registration is unavailable.
3. Add a distinct versioned registration request, for example
   `eligibility_contract:'eligibility-v2'`, `eligibility_confirmed:true`, and
   `accepted_policy_version:<new reviewed version>`. Give the new field the
   exact reviewed meaning: meets Ziipa's minimum and any higher applicable
   threshold, with required guardian permission handled by the reviewed flow.
   Never synthesize the legacy adult flag. Reject mixed/unknown contracts and
   missing/false acknowledgments.
4. Store a separate, versioned self-attestation receipt describing the exact
   statement, policy version, source contract and time. Preserve legacy adult
   receipts unchanged. Do not infer dates of birth, guardian verification or
   minor status from them. Review any additional age/jurisdiction data before
   collecting it; no birth date is needed merely to rename a Boolean field.
5. Route both legacy web-portal registration and shared Android/iOS/Studio
   registration through the reviewed contract. Deploy server support first;
   update both clients without automatic fallback to the old adult payload.
   Existing compatible login sessions need no false new age declaration.
6. Test unsupported server/client combinations, rejected/absent declarations,
   policy-version mismatch, non-overwritten legacy receipts and both web/native
   registration paths. Test any required guardian and higher-minimum flow before
   admitting that audience. Publish updated policies and build new mobile/web
   artifacts together only after acceptance; preserve current Android 1.0.14
   evidence separately.

This proposal does not decide a universal legal minimum. Owner review should
use applicable primary guidance, including the
[FTC children's privacy guidance](https://www.ftc.gov/business-guidance/privacy-security/childrens-privacy),
and the rules in intended distribution territories. No agreement or legal
declaration is accepted on the owner's behalf here.

## Release boundaries

The candidate updates public operator/support metadata and sets the supported
EAS Submit `ios.ascAppId` string only. Expo documents this identifier as the
existing App Store Connect app ID in its
[EAS Submit schema](https://docs.expo.dev/eas/json/).
No Apple login, signing key, certificate, provisioning profile or submission
credential is stored in source.

`mobile/scripts/check-release.cjs`, signing/encryption declarations, Web3
requirements and every review acknowledgment remain unchanged. There is no
beta-specific bypass. No source archive, cloud build, IPA/APK signing, upload,
TestFlight distribution, commit or deployment is performed by this candidate.
