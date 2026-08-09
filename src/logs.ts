

import { NextFunction, Request,Response } from "express";
import * as z from "zod";
import { insertLogs } from "./db/query/addLog.js";
import { newLog } from "./db/schema.js";
import { getLogs } from "./db/query/getLgs.js";


export async function ingestLogs(
    req:Request,
    res:Response,
){

    const levelSchema = z.enum(["debug", "info", "warn", "error"]);
    //a string --> .string() ,  checks valid ISO 8601 format -->  .datetime()
    const timestampSchema = z.string().datetime().refine(
        (val) => {
            const inputDate = new Date(val);
            const maxDate = new Date(Date.now()+5*60*1000);
            return inputDate <= maxDate;
        },{
            message:"Timestamp cannot be more than 5 minutes in the future",
        }
    ).transform((val) => new  Date(val));
    const serviceMessageSchema = z.string().min(1); // must be non-empty

    const attributesSchema = z.record( // an object with arbitrary keys --> z.record(keyType, valueType)
        z.string(), // keys are strings
        z.union([z.string(),z.number(),z.boolean()]) // values are one of these
    ).optional();

    const schema = z.object({
        "timestamp" : timestampSchema,
        "level":levelSchema,
        "service":serviceMessageSchema,
        "message":serviceMessageSchema,
        "attributes": attributesSchema,
    });

    const batchSchema = z.object({
        logs : z.array(z.any())// we dont what each entry check here we jush want to check the out struct so we used any() 
    });

    // check if req.body is an object with a logs array 
    const body = batchSchema.safeParse(req.body);
    if (!body.success){
        return res.status(400).json({
            error:"Invalid request body",
        });
    }
    const logs = body.data.logs;
    let rejected : {index : number , reason : string}[] = [];
    let accepted=0;
    let arraccepted : newLog[] =[];
    // validate each entry
    for (let i = 0;i<logs.length;i++){
        try{
            const val = schema.parse(logs[i]);
            accepted++;
            arraccepted.push(val);
        }catch(err){
            if (err instanceof z.ZodError){
                console.log(`Entry ${i} is Invalid : ${err.message}`);
                rejected.push({
                    index:i,
                    reason:err.issues.map((issue)=>issue.message).join(", ")
                });
            }
        }
    }
    if (accepted == 0){
        return res.status(400).json({error : "all entries are invalid"});
    }

    await insertLogs(arraccepted);

    res.status(200).json({
        "accepted":accepted,
        "rejected":rejected
    });
    
}


// ------------------ get logs ----------------------------------------------------------



export async function gLogs(req:Request,res:Response,next:NextFunction){

    try{
        const parms = req.query.service;

        const logs = await getLogs(100,typeof parms === 'string' ? parms : undefined);

        res.status(200).json({"logs" : logs});
    }catch (err){
        next(err);
    }
    

}