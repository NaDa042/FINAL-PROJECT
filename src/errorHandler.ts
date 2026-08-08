

import { Request,Response,NextFunction } from "express";

export function errorHandler(
    err:Error,
    req:Request,
    res:Response,
    next:NextFunction
){
    console.log(err.message);
    if (err instanceof error400)
        res.status(400).json({"error": err.message});
    else if (err instanceof error401)
        res.status(401).json({"error": err.message});
    else if (err instanceof error403)
        res.status(403).json({"error": err.message});
    else if (err instanceof error404)
        res.status(404).json({"error": err.message});
    else 
        res.status(400).json({"error" : err.message});
}

export class error400 extends Error{
    constructor(mes:string){
        super(mes);
        this.name = "BadRequestError";
    }
}

export class error401 extends Error{
    constructor(mes:string){
        super(mes);
        this.name = "UnauthorizedError";
    }
}

export class error403 extends Error{
    constructor(mes:string){
        super(mes);
        this.name = "ForbiddenError";
    }
}

export class error404 extends Error{
    constructor(mes:string){
        super(mes);
        this.name = "NotFoundError";
    }
}