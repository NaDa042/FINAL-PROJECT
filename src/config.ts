process.loadEnvFile();

type APIConfig = {
  db: {
    url: string,
    migrationConfig: {
      migrationsFolder: string,
    },
    retentionDays:number
  },
};

function envOrThrow<T>(key: string,parse:(raw:string)=>T):T {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Environment variable ${key} is not set`);
  }
  return parse(value);
}

export const config: APIConfig = {
  db: {
    url: envOrThrow("DATABASE_URL", (v)=>v),//no change no need fo parse here
    migrationConfig: {
      migrationsFolder: "src/db/migrations", // must match `out` in drizzle.config.ts
    },
    retentionDays:envOrThrow("RETENTION_DAYS",(v)=>{
      const num = Number(v);
      if (Number.isNaN(num)) throw new Error("RETENTION_DAYS must be a number");
      return num;
    })
  },
};