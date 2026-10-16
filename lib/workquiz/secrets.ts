type SecretName = "WORKQUIZ_SECRET" | "WORKQUIZ_CRON_SECRET";

const DEV_FALLBACKS: Record<SecretName, string> = {
  WORKQUIZ_SECRET: "dev-secret",
  WORKQUIZ_CRON_SECRET: "dev-cron-secret",
};

/**
 * Reads a server secret. Development and tests fall back to a fixed value;
 * production refuses to, because those fallbacks are public in this repo and
 * would let anyone forge admin-token hashes or call the scheduler route.
 */
export function readSecret(name: SecretName) {
  const value = process.env[name];
  if (value) {
    return value;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(`${name} must be set in production.`);
  }

  return DEV_FALLBACKS[name];
}

/** Throws at startup if any secret is missing, instead of on the first request. */
export function assertSecretsConfigured() {
  for (const name of Object.keys(DEV_FALLBACKS) as SecretName[]) {
    readSecret(name);
  }
}
