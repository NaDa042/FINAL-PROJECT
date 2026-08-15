


import { NextFunction, Request,Response } from "express";
import z from "zod";
import { checkParse } from "./logs.js";
import { aggLogs } from "./db/query/aggLogs.js";
import { canServeFromRollup, queryRollup } from "./rollup.js";




export async function AggregateLogs(req:Request,res:Response,next:NextFunction){

    try{
        let {service, level, since, until ,q,bucket,group_by} = req.query;
        // handle level filter
        const levelSchema = z.enum(["debug", "info", "warn", "error"]);
        const validateLevel= checkParse(levelSchema,level);
        if (validateLevel === null) {
            return res.status(400).json({
                "error": "Unsupported log level",
            });
        }

        // handle since and until filters
        const dateSchema = z.string().datetime().transform((val)=>new Date(val));
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
        if ((validateSince === undefined) || validateUntil === undefined){
            return res.status(400).json({
                "error" : "since & until are required fields"
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



        // handle bucket 
        const bucketSeconds: Record<string, number> = {
            "1m": 60,
            "5m": 300,
            "1h": 3600,
            "1d": 86400,
        };
        const bucketSchema = z.enum(["1m","5m","1h","1d"]);
        const validateBucket = checkParse(bucketSchema,bucket);
        if (validateBucket === null){
            return res.status(400).json({
                "error" : "bucket value is invalid"
            })
        }
        if (validateBucket === undefined){
            return res.status(400).json({
                "error" : "bucket value is required"
            })
        }


        const groupBySchema = z.enum(["service","level"]);
        const validategroupBy = checkParse(groupBySchema,group_by);
        if (validategroupBy ===  null){
            return res.status(400).json({
                "error" : "invlaid group_by value"
            })
        }


        const hasAttrFilter = Object.keys(attrRecord).length > 0;
        const hasMessageFilter = typeof q == "string" && q.length > 0;

        const RollupParams = {
            since:validateSince,
            until:validateUntil,
            bucketSeconds: bucketSeconds[validateBucket],
            service: typeof service == "string" ? service:undefined,
            level: validateLevel,
            hasAttrFilter,
            hasMessageFilter,
            groupBy: validategroupBy,
        };

        if (canServeFromRollup(RollupParams)){
            return res.status(200).json({buckets:queryRollup(RollupParams)});
        }
             

        const agg = await aggLogs(            
            validateSince,
            validateUntil,
            bucketSeconds[validateBucket],
            typeof service === 'string' ? service : undefined,
            validateLevel,
            attrRecord,
            typeof q ==='string' ? q : undefined,
            validategroupBy
        );


        const editAggs = agg.map((buck) => ({
            ...buck,
            start: new Date(buck.start).toISOString(),//overwrite the ori start 
        }));

        res.status(200).json({
            "buckets" : editAggs
        });

    }catch (err){
        next(err);
    }
}
