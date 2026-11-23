import 'reflect-metadata';
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { ZodError } from 'zod';
import { config } from './common/config.js';
import { pool } from './common/db.js';
import { AuthController, AuthGuard } from './auth/auth.js';
import { TenantsController, TenantsService } from './tenants/tenants.js';
import { MetamodelController, MetamodelService } from './metamodel/metamodel.js';
import { ApprovalsController, RecordsController, RecordsService } from './records/records.js';
import { ExcelController } from './io/excel.js';
import { ViewpointsController } from './viewpoints/viewpoints.js';
import { IntegrationsController, IntegrationsService, startScheduler } from './integrations/integrations.js';

/** Turn validation and database errors into clean JSON; never leak SQL or stack traces. */
@Catch()
class ErrorFilter implements ExceptionFilter {
  catch(err: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    if (err instanceof HttpException) return res.status(err.getStatus()).json(err.getResponse());
    if (err instanceof ZodError) return res.status(400).json({ message: 'مدخلات غير صالحة', errors: err.issues.map((i) => ({ key: i.path.join('.'), message: i.message })) });
    const code = (err as { code?: string }).code;
    if (code === '23505') return res.status(409).json({ message: 'القيمة موجودة مسبقاً' });
    if (code === '23503') return res.status(400).json({ message: 'مرجع غير موجود' });
    if (code === '42501') return res.status(403).json({ message: 'غير مصرح' }); // RLS violation
    if (code === '22P02') return res.status(400).json({ message: 'معرّف غير صالح' });
    console.error(err);
    return res.status(500).json({ message: 'خطأ داخلي' });
  }
}

@Module({
  controllers: [AuthController, TenantsController, MetamodelController, RecordsController, ApprovalsController, ExcelController, ViewpointsController, IntegrationsController],
  providers: [TenantsService, MetamodelService, RecordsService, IntegrationsService, { provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule {}

export async function createApp() {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  app.enableCors({ origin: config.corsOrigin.split(','), credentials: false });
  app.useGlobalFilters(new ErrorFilter());
  app.setGlobalPrefix('api');
  return app;
}

if (process.argv[1]?.endsWith('main.js')) {
  const app = await createApp();
  await app.listen(config.port);
  console.log(`Bunyan API on :${config.port}`);
  if (config.scheduler) startScheduler(app.get(IntegrationsService));
  const stop = async () => { await app.close(); await pool.end(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
