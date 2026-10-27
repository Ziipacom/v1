# Limited external iPhone beta preparation

`ios-external-testflight` is a separate **preparation** target. It does not approve
external distribution, submit a build, invite testers, enable a public link, or
authorize a public App Store release. Policy publication, reviewer setup, device
acceptance and Apple beta review are deliberately pending. Do not withdraw,
replace or resubmit an already queued review without the owner's decision.

The profile retains `com.ziipa.app`, Team `L6WH6BD2N5`, App Store Connect app
`6827668999`, EAS project `a130b762-6812-4963-9ebd-5d103a24084e`, live API
`https://api.ziipa.com`, version `1.0.14` and the exact Z avatar icon. Remote EAS
versioning increments the next build number; verify its actual value before a
job. There is no automatic submission. Check the real remaining free allowance
and stop if a charge or plan change is required.

The original `ios-internal-testflight` profile and production checker remain
unchanged. Unknown/mixed scope markers, different identity, another API/privacy
URL, automatic submission and claimed approval markers fail this preparation
gate. Passing it verifies configuration only. It is not evidence that a policy
is published, credentials/reviewer access work, Apple approved the build, or
that final distribution is authorized.

Both limited iOS scopes share the same runtime restrictions. The legacy
`iosInternalTestflight` export is retained as a compatibility name for that
shared boolean because existing transport and action guards already use it.
New code should use `iosLimitedTestflight` or an audience-specific predicate.
Ordinary web and Android behavior is unchanged.

Existing Ziipa accounts can sign in and test owned media, profile images and
private drafts. New registration is unavailable. The current adult (18+)
registration/terms contract is unchanged; an existing login does not by itself
prove age. A public TestFlight invitation does not create a Ziipa account.
Wallet pairing/signing/transactions, new network authorization/imports and
remote push remain blocked, including direct API and workflow paths. Disconnect,
unlink, pause/cancel/delete cleanup remains available. The shared beta plugin
removes APNs enrollment/background notifications; inspect the final signed IPA
again. Video rendering remains unavailable while its worker is blocked.

The external preparation profile pins the **planned** beta privacy URL
`https://ziipa.com/privacy-beta`, operator Niche Labs LLC and monitored contact
`ziipaziipa@gmail.com`. Its in-app link does not label that URL published.
Root separately prepares the factual policy for owner approval and publication;
verify the approved page is publicly readable without account credentials.
Do not substitute the narrow network-import notice for a complete beta privacy
notice, or claim the existing terms/community drafts are final policies.

Before any external distribution, root must separately verify the published
policy and matching TestFlight privacy URL, accurate beta description/What to
Test, contact information, valid dedicated reviewer account and device results.
Enter reviewer credentials only in App Store Connect's dedicated fields, not
source, EAS environment variables, public notes or chat logs. The actual final
IPA must pass identity/icon/privacy-purpose/signing checks and the owner must
answer Apple's export-compliance questions; this profile does not assume an
encryption exemption. Wallet/WebRTC encryption can remain in the binary while
their actions are restricted.

The first external build requires Apple's beta review. Only an approved
external-test build associated with the intended group can support the final
public invitation. Source scope markers do not implement Apple's immutable
`TestFlight Internal Only` export restriction, and do not prevent an account
administrator from selecting another distribution action. Keep final owner
checks and Apple review distinct from this preparation build.

References: [Expo SDK 57](https://docs.expo.dev/versions/v57.0.0/),
[external testers](https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers),
[beta review information](https://developer.apple.com/documentation/appstoreconnectapi/betaappreviewdetail/attributes-data.dictionary).
