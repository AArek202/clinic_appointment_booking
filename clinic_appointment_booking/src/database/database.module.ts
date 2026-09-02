import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        url: config.getOrThrow<string>('DATABASE_URL'),
        autoLoadEntities: true,
        // Never true, in any environment. Schema changes go through migrations.
        synchronize: false,
        // Migrations are run by the dedicated `migrate` service, not on boot.
        migrationsRun: false,
      }),
    }),
  ],
})
export class DatabaseModule {}
