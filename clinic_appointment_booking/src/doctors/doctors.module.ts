import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { Doctor } from './doctor.entity';
import { DoctorsController } from './doctors.controller';
import { DoctorsRepository } from './doctors.repository';
import { DoctorsService } from './doctors.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Doctor]),
    UsersModule,
    forwardRef(() => AuthModule),
  ],
  controllers: [DoctorsController],
  providers: [DoctorsRepository, DoctorsService],
  exports: [DoctorsRepository],
})
export class DoctorsModule {}
