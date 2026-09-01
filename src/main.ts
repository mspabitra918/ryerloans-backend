import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp, SWAGGER_PATH } from './setup';

// Local / long-running HTTP bootstrap. On Vercel the app is served through the
// serverless handler in api/index.ts instead, which reuses configureApp().
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  configureApp(app);

  app.getHttpAdapter().get('/', (req, res) => {
    res.json({
      success: true,
      message: 'RiverCash Loans Backend API is running successfully.',
    });
  });

  const port = process.env.PORT ?? 4000;
  await app.listen(port);

  console.log(`API running at:     http://localhost:${port}`);

  // Mirrors the condition in setup.ts, so this line cannot claim docs are
  // served when they are not — which is what it used to do.
  const swaggerEnabled =
    process.env.SWAGGER_ENABLED === 'true' ||
    (process.env.SWAGGER_ENABLED !== 'false' &&
      process.env.NODE_ENV !== 'production');

  if (swaggerEnabled) {
    console.log(`Swagger running at: http://localhost:${port}/${SWAGGER_PATH}`);
  }
}

bootstrap();
