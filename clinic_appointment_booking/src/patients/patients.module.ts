import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Patient } from './patient.entity';
import { PatientsRepository } from './patients.repository';

@Module({
  imports: [TypeOrmModule.forFeature([Patient])],
  providers: [PatientsRepository],
  exports: [PatientsRepository],
})
export class PatientsModule {}
