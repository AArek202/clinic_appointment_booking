import { Module } from '@nestjs/common';
import { AnalyticsRepository } from './analytics.repository';

// No TypeOrmModule.forFeature: the repository executes raw SQL through the
// injected DataSource and owns no entity.
@Module({
  providers: [AnalyticsRepository],
  exports: [AnalyticsRepository],
})
export class AnalyticsModule {}
