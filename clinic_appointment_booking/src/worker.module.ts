import { Module } from '@nestjs/common';
import { ClockModule } from './common/clock/clock.module';
import { AppConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { ProcessorsModule } from './jobs/processors.module';

/**
 * Root module of the worker process.
 *
 * Same codebase as the API, different composition: no controllers, no
 * ValidationPipe, no HTTP server — and this is the only module tree that
 * includes ProcessorsModule.
 */
@Module({
  imports: [AppConfigModule, DatabaseModule, ClockModule, ProcessorsModule],
})
export class WorkerModule {}
