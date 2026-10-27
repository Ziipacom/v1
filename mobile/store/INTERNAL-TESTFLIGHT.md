# Private iPhone beta build scope

This is an explicit first-device TestFlight target for the owner and their App
Store Connect team. It is not production acceptance, an external beta or a public
App Store release. The existing production checker remains unchanged.

`ios-internal-testflight` uses the production Ziipa bundle `com.ziipa.app`, Apple
Team `L6WH6BD2N5`, App Store Connect app `6827668999`, the existing Ziipa EAS
project, and `https://api.ziipa.com`. It uses the built-in EAS preview environment
with dotenv loading disabled. Verify remaining Free allowance before any job;
stop on charges or an upgrade. No signing or upload is performed by these source
changes.

Existing accounts can sign in and test their profile, owned media and private
draft persistence. New registration is unavailable in this beta. The existing
normal-client adult registration contract is unchanged. Uploads and edits use
the live account; testers must choose their own test media deliberately.

Native transport and direct action guards block wallet pairing, signing,
transactions, network authorization/imports and workflows that could sync a
network. Wallet unlink, provider disconnect and workflow pause/cancel/delete
remain available. Read-only workspace functions and other core Media OS tools
remain available. These client guards do not stop previously scheduled server
jobs or restrict the separate website/Android app.

Remote push enrollment is unavailable. The beta-only config plugin removes its
APNs entitlement and remote-notification background mode; in-app messages and
notification preferences remain available. Verify the generated entitlements
again in the final signed IPA. Do not create an APNs key or synchronize Apple
capabilities for this beta by implication.

Video rendering is unavailable while the production worker awaits recovery.
Physical iPhone acceptance remains **pending**. Initial tests should use private
drafts, not claim a completed export or publish a test creation automatically.

The beta deliberately omits `ITSAppUsesNonExemptEncryption`. This is not a claim
that the binary has no encryption or is exempt. Inventory the final IPA and have
the owner answer Apple's export-compliance questions before tester distribution.
WalletConnect/native WebRTC crypto can remain in the binary even when its
actions are disabled. Do not set production review acknowledgments to obtain the
first beta.

Freeze/review the exact source, inspect a mobile-only archive, and verify the
specific signing identity before an authorized free EAS build. Do not use
automatic submission or `--latest`. After final binary inspection, select only
its exact build ID for upload. Manually verify the private internal tester group,
automatic distribution off and no public link. The scope marker and notice do
not establish Apple's `TestFlight Internal Only` export restriction; do not claim
that an administrator could not otherwise submit the IPA publicly.

Public policies, external/public release, full device acceptance and the Web3
production checklist remain separate work. This target does not publish a policy,
change age eligibility, activate a provider, or recover the rendering worker.
