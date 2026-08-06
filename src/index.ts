
import express from "express";
import { firstHandler } from "./healths.js";


const app = express(); // start the app
const PORT = 8080; // choose the port 



// choose the html file from the app folder
app.use("/app", express.static("./src/app"));

//get
app.get("/healths",firstHandler);
//end get

app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});
