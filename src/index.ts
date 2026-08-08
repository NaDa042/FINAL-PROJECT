
import express from "express";
import { health } from "./health.js";



import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import { config } from "./config.js";



const migrationClient = postgres(config.db.url, { max: 1 });
await migrate(drizzle(migrationClient), config.db.migrationConfig);



const app = express(); // start the app
const PORT = 8080; // choose the port 


app.use(express.json()); // so the app accepts json requests 



//get 
app.get("/health",health); // checks if the app is ready to accept requests
//end get



app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});
