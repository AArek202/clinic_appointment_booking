import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Doctor } from './doctor.entity';
import { DoctorsRepository } from './doctors.repository';

@Module({
  imports: [TypeOrmModule.forFeature([Doctor])],
  providers: [DoctorsRepository],
  exports: [DoctorsRepository],
})
export class DoctorsModule {}
