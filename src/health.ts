




import { Request, Response } from "express";
import { checkConnection, checkMigrations } from "./db/query/check.js";

export async function health(req:Request,res:Response) {
    res.set("Content-Type", "text/plain; charset=utf-8");

    try{
        await checkConnection();
        await checkMigrations();
        res.status(200).send("ready to accept requests")
    }
    catch(err){
        res.status(503).send("DB isn't ready. Service Unavailable");
    }

}