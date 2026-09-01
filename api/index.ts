import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import express, { Express, Request, Response } from 'express';

// IMPORTANT: import the *compiled* app from dist, not from ../src.
// Vercel bundles this handler with esbuild, which does NOT emit the
// `emitDecoratorMetadata` reflection that NestJS DI and sequelize-typescript
// need. `nest build` (tsc) runs first (see vercel.json buildCommand) and bakes
// that metadata into dist/**, so importing the compiled output keeps DI working.
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/setup';

// Reuse one initialised Nest instance across warm invocations.
let cachedServer: Express | null = null;

async function bootstrap(): Promise<Express> {
  if (cachedServer) return cachedServer;

  const expressApp = express();
  const app = await NestFactory.create(
    AppModule,
    new ExpressAdapter(expressApp),
  );
  configureApp(app);
  await app.init();

  cachedServer = expressApp;
  return cachedServer;
}

export default async function handler(req: Request, res: Response) {
  const server = await bootstrap();
  return server(req, res);
}
