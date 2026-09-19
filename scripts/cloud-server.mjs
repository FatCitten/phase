#!/usr/bin/env node
import { startPhaseCloudServer } from '../src/cloud-server.mjs';
import { resolve } from 'node:path';

const port=Number(process.env.PHASE_CLOUD_PORT??8787);
const key=process.env.PHASE_CLOUD_DEV_KEY??'phase-dev-key';
const privateLog=resolve(process.env.PHASE_CLOUD_PRIVATE_LOG??'.phase/cloud/private.ndjson');
const productLog=resolve(process.env.PHASE_CLOUD_PRODUCT_LOG??'.phase/cloud/product.ndjson');
const cloud=await startPhaseCloudServer({host:process.env.PHASE_CLOUD_HOST??'127.0.0.1',port,apiKeys:{[key]:{account:'dev',premium:true}},privateLog,productLog});
console.log(`Phase Cloud dev server ${cloud.url}`);
console.log(`private: ${privateLog}`);
console.log(`product: ${productLog}`);
