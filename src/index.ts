
import express from "express";
import { health } from "./health.js";



import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import { config } from "./config.js";
import { gLogs, ingestLogs } from "./logs.js";
import { errorHandler } from "./errorHandler.js";
import { AggregateLogs } from "./aggregate.js";
import { runRetention } from "./runRetention.js";



const migrationClient = postgres(config.db.url, { max: 1 });
await migrate(drizzle(migrationClient), config.db.migrationConfig);



const app = express(); // start the app
const PORT = 8080; // choose the port 


app.use(express.json()); // so the app accepts json requests 



//get 
app.get("/health",health); // checks if the app is ready to accept requests
app.get("/logs",gLogs);
app.get("/logs/aggregate",AggregateLogs);
//end get


//post
app.post("/logs",ingestLogs);



app.use(errorHandler); //should be here after all the routes and other middlewares

app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});

await runRetention(new Date(Date.now() - config.db.retentionDays * 24 * 60 * 60 * 1000),10000);


setInterval(async()=>{
  await runRetention(new Date(Date.now() - config.db.retentionDays * 24 * 60 * 60 * 1000),10000);
}, 60 * 60 * 1000);



