
import express from "express";
import { firstHandler } from "./health.js";


const app = express(); // start the app
const PORT = 8080; // choose the port 



// choose the html file from the app folder

//get
app.get("/health",firstHandler);
//end get

app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});
