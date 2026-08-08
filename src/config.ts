process.loadEnvFile();

type APIConfig = {
  db: {
    url: string,
    migrationConfig: {
      migrationsFolder: string,
    },
  },
};

function envOrThrow(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Environment variable ${key} is not set`);
  }
  return value;
}

export const config: APIConfig = {
  db: {
    url: envOrThrow("DATABASE_URL"),
    migrationConfig: {
      migrationsFolder: "src/db/migrations", // must match `out` in drizzle.config.ts
    },
  },
};