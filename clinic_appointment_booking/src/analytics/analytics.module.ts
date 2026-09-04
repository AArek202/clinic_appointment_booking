import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsRepository } from './analytics.repository';
import { AnalyticsService } from './analytics.service';

// No TypeOrmModule.forFeature: the repository executes raw SQL through the
// injected DataSource and owns no entity.
@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsService, AnalyticsRepository],
  exports: [AnalyticsRepository],
})
export class AnalyticsModule {}
