const strict =
  process.argv.includes("--strict") ||
  process.env.EAS_BUILD_PROFILE === "production" ||
  process.env.APP_VARIANT === "production";
if (!strict) {
  console.log("Preview build: production release checks are not required.");
  process.exit(0);
}
const errors = [];
const env = process.env;
for (const name of [
  "EXPO_PUBLIC_API_URL",
  "EXPO_PUBLIC_PRIVACY_URL",
  "EXPO_PUBLIC_TERMS_URL",
  "EXPO_PUBLIC_COMMUNITY_URL",
  "EXPO_PUBLIC_DELETE_ACCOUNT_URL",
  "EXPO_PUBLIC_WALLET_ORIGIN",
]) {
  try {
    const url = new URL(env[name] || "");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !url.hostname.includes(".") ||
      url.hostname.includes(":") ||
      /^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname) ||
      /localhost|127\.0\.0\.1|10\.0\.2\.2|example|YOUR-|\.(local|test|invalid)$/i.test(
        url.hostname,
      )
    )
      throw new Error();
    if (
      name === "EXPO_PUBLIC_API_URL" &&
      (url.pathname !== "/" || url.search || url.hash)
    )
      throw new Error();
  } catch {
    errors.push(`${name} must be a verified, public HTTPS URL.`);
  }
}
if (
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    env.EXPO_EAS_PROJECT_ID || "",
  )
)
  errors.push(
    "EXPO_EAS_PROJECT_ID is required; link a project in your Expo account.",
  );
if (!env.EXPO_OWNER)
  errors.push("EXPO_OWNER must identify your Expo organization/account.");
if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$/i.test(env.ZIIPA_APP_ID || ""))
  errors.push(
    "ZIIPA_APP_ID must be your verified iOS bundle ID / Android application ID.",
  );
if (env.APP_VARIANT !== "production")
  errors.push("APP_VARIANT must be production.");
if (env.EXPO_PUBLIC_PORTAL_MODE === "true")
  errors.push(
    "EXPO_PUBLIC_PORTAL_MODE must not enable a web-only store build.",
  );
if (
  env.ZIIPA_APP_ID_CONFIRMED !== "true" ||
  /\.preview$/i.test(env.ZIIPA_APP_ID || "")
)
  errors.push(
    "Confirm ownership of the production app identifier in both stores; preview identifiers cannot be submitted.",
  );
if (env.ZIIPA_SIGNING_REVIEWED !== "true")
  errors.push(
    "Verify owner-controlled signing credentials and existing store upload certificate before setting ZIIPA_SIGNING_REVIEWED=true. Never use the preview/debug key.",
  );
if (
  env.ZIIPA_ENCRYPTION_REVIEWED !== "true" ||
  !["true", "false"].includes(env.ZIIPA_USES_NON_EXEMPT_ENCRYPTION || "")
)
  errors.push(
    "Complete the Apple export-compliance review and explicitly configure ZIIPA_USES_NON_EXEMPT_ENCRYPTION=true or false; no exemption is assumed.",
  );
if (
  env.EXPO_PUBLIC_ENABLE_DEMO !== "false" ||
  env.EXPO_PUBLIC_ENABLE_CONCEPTS !== "false"
)
  errors.push("Demo mode and unconnected concept categories must be disabled.");
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(env.EXPO_PUBLIC_SUPPORT_EMAIL || ""))
  errors.push("Set the monitored support email.");
if (env.ZIIPA_RELEASE_REVIEWED !== "true")
  errors.push(
    "Complete store/RELEASE.md, including device testing, moderation, privacy, and backend deployment, before setting ZIIPA_RELEASE_REVIEWED=true.",
  );
if (!/^[0-9a-f]{32}$/i.test(env.EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID || ""))
  errors.push(
    "Set your verified WalletConnect project ID and configure its allowed application origin.",
  );
if (env.ZIIPA_WEB3_REVIEWED !== "true")
  errors.push(
    "Complete ../WEB3.md: contract review, public testnet deployment, pinning, physical-wallet/device QA, and current store-policy review.",
  );
if (errors.length) {
  console.error("Release blocked:\n- " + errors.join("\n- "));
  process.exit(1);
}
console.log(
  "Release configuration checks passed. These acknowledgments do not verify signing credentials, deployed services, device results or store approval; inspect the final signed artifact and owner consoles.",
);
