import 'reflect-metadata';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { parseEnvironment } from '@authcore/config';
import { AppModule } from './app.module.js';
import { startApi } from './bootstrap.js';
loadEnvFile(resolve(process.cwd(), '../../.env'));
void startApi(AppModule, parseEnvironment(process.env));
