




import { Request, Response } from "express";


export async function firstHandler(req:Request,res:Response) {
    res.status(200).set("Content-Type", "text/plain; charset=utf-8").send("donee yaayyyy");
}