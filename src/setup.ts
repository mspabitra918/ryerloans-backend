import { INestApplication, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

/** Path the interactive docs are served from. */
export const SWAGGER_PATH = 'api-docs';

/**
 * Applies the shared runtime configuration (validation, CORS, Swagger) to a
 * Nest application. Used by both the local HTTP bootstrap (src/main.ts) and the
 * Vercel serverless handler (api/index.ts) so they behave identically.
 */
export function configureApp(app: INestApplication): void {
  // Lock down request bodies: strip unknown props, reject extras, coerce types.
  // Without this the class-validator decorators on the DTOs are not enforced.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Allow the Next.js frontend to call the API from the browser.
  // In production, set FRONTEND_URL to the deployed frontend origin.
  // Accept a comma-separated list in CORS_ORIGINS; during local
  // development also allow the common Next dev origin.
  const defaultProdOrigin = 'https://lakeside-loans.vercel.app';
  const envOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  const origins =
    envOrigins.length > 0
      ? envOrigins
      : process.env.NODE_ENV !== 'production'
        ? [
            defaultProdOrigin,
            'https://ryerloans-frontend.vercel.app',
            'http://localhost:3000',
            'http://localhost:3001',
          ]
        : [defaultProdOrigin];

  app.enableCors({
    origin: origins,
    credentials: true,
  });

  setupSwagger(app);
}

/**
 * Interactive API docs.
 *
 * Disabled when SWAGGER_ENABLED is explicitly "false", and off by default in
 * production: this API's surface is admin actions over borrower PII, and a
 * public schema of it is free reconnaissance. Set SWAGGER_ENABLED=true to opt
 * back in for a deployed environment.
 */
function setupSwagger(app: INestApplication): void {
  const explicit = process.env.SWAGGER_ENABLED;

  const enabled =
    explicit === 'true' ||
    (explicit !== 'false' && process.env.NODE_ENV !== 'production');

  if (!enabled) return;

  const config = new DocumentBuilder()
    .setTitle('Ryer Loans API')
    .setDescription(
      'Borrower application intake, the §6 status state machine, the §7 email ' +
        'automation sequences, and the §8.4 admin action endpoints.',
    )
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Admin JWT issued at sign-in.',
      },
      'admin-jwt',
    )
    .addTag('applications', 'Borrower applications and admin action buttons')
    .addTag('email', 'Unsubscribe and ESP bounce/complaint webhooks')
    .build();

  const document = SwaggerModule.createDocument(app, config);

  SwaggerModule.setup(SWAGGER_PATH, app, document, {
    swaggerOptions: {
      // Keep the entered bearer token across page reloads.
      persistAuthorization: true,
    },
  });
}
