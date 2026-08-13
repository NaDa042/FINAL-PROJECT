

import { NextFunction, Request,Response } from "express";
import * as z from "zod";
import { insertLogs } from "./db/query/addLog.js";
import { levelEnum, newLog } from "./db/schema.js";
import { getLogs } from "./db/query/getLgs.js";
import { error400 } from "./errorHandler.js";


// -------------------------------------------------
function normalizeAttributes(attrs?: Record<string, string | number | boolean>) {
  if (!attrs) return attrs;
  return Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, String(v)]));
}
// --------------------------------------------

const levelSchema = z.enum(["debug", "info", "warn", "error"]);
const timestampSchema = z.string().datetime().refine(
    (val) => {
        const inputDate = new Date(val);
        const maxDate = new Date(Date.now()+5*60*1000);
        return inputDate <= maxDate;
    },{
        message:"Timestamp cannot be more than 5 minutes in the future",
    }
).transform((val) => new  Date(val));

//a string --> .string() ,  checks valid ISO 8601 format -->  .datetime()
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

export async function ingestLogs(
    req:Request,
    res:Response,
){
    
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
            // -------------------------------------------------------------------------------------------------------------------------------
            val.attributes = normalizeAttributes(val.attributes);
            // -------------------------------------------------------------------------------------------------------------------------------
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


export function checkParse<T>(schema: z.ZodType<T>, value: unknown): T | null | undefined{
    if (value === undefined) return undefined;
    const result = schema.safeParse(value);

    if (!result.success) {
        return null;
    }

    return result.data;
}

function encodeCursor(timestamp:Date,id:string):string{

    const strjson = JSON.stringify({timestamp:timestamp,id:id});
    const result = Buffer.from(strjson).toString('base64');
    return result;
}
function decodeCursor(cursor: string): { timestamp: Date, id: string } {
    const strjson = Buffer.from(cursor,'base64').toString('utf-8');
    const result =  JSON.parse(strjson);
    const ans = {
        timestamp : new Date(result.timestamp),
        id : result.id
    }
    return ans;
}

const dateSchema = z.string().datetime().transform((val)=>new Date(val));
const limitSchema = z.coerce.number().int().positive(); // Convert the input to a number → make sure it's an integer → make sure it's positive.

export async function gLogs(req:Request,res:Response,next:NextFunction){

    try{

        // extract filters values from the request
        let {service, level, since, until ,q,limit,cursor} = req.query;

        // handle level filter
        const validateLevel= checkParse(levelSchema,level);
        if (validateLevel === null) {
            return res.status(400).json({
                "error": "Unsupported log level",
            });
        }

        // handle since and until filters
        const validateSince = checkParse(dateSchema,since);
        const validateUntil = checkParse(dateSchema,until);
        if (validateSince === null || validateUntil === null){
            return res.status(400).json({
                "error": "invalid since or until value",
            });
        }
        if ((validateSince!==undefined && validateUntil !== undefined) && validateSince > validateUntil){
            return res.status(400).json({
                "error" : "until earlier than since"
            })
        }

        // handle attr.<key>
    
        const attrRecord = Object.fromEntries(
        Object.entries(req.query)
            .filter(([key,value]) => key.startsWith("attr.") && typeof value === "string")
            .map(([key, value]) => [
            key.slice(5),
            value
            ])
        )as Record<string, string>;


        // limit error-check
        const validateLimit = checkParse(limitSchema,limit);
        if (validateLimit === null){
            return res.status(400).json({
                "error" : "Non-numeric limit"
            });
        }
        if (validateLimit !== undefined && validateLimit > 1000){
            return res.status(400).json({
                "error" : "Limit outside the supported range (1000)"
            });
        }
        const resolvedLimit = validateLimit ?? 100;


        // handle cursor
        const cursorObj = cursor? decodeCursor(cursor as string) : undefined;

        const logs = await getLogs(
            resolvedLimit,
            typeof service === 'string' ? service : undefined,
            validateLevel,
            validateSince,
            validateUntil,
            attrRecord,
            typeof q ==='string' ? q : undefined,
            (cursorObj !== undefined) ? cursorObj : undefined 
        );


        const hasNextPage = logs.length >resolvedLimit;
        const returnedLogs = hasNextPage
        ?logs.slice(0,resolvedLimit)
        :logs;
        const nextCursor = hasNextPage?
        encodeCursor(
            returnedLogs[returnedLogs.length-1].timestamp,
            returnedLogs[returnedLogs.length-1].id,
        ):null;
        

        res.status(200).json({"logs" : returnedLogs , "next_cursor" : nextCursor});
    }catch (err){
        next(err);
    }
    

}