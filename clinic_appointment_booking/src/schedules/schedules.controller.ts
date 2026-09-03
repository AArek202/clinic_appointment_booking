import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { DoctorOwnershipGuard } from '../auth/guards/doctor-ownership.guard';
import { CreateScheduleDto } from './dto/create-schedule.dto';
import { UpdateScheduleDto } from './dto/update-schedule.dto';
import { Schedule } from './schedule.entity';
import { SchedulesService } from './schedules.service';

/**
 * Nested under the doctor so the ownership guard has an explicit subject to
 * check (docs/API.md). Reading is open to any authenticated caller — a patient
 * needs to see when a doctor works. Writing is ADMIN or the addressed doctor.
 *
 * DoctorOwnershipGuard alone is enough on the writes: it passes for ADMIN, and
 * otherwise compares :doctorId to the caller's own doctors.id. A patient has no
 * doctorId, so the comparison fails and the request gets 403 without a separate
 * RolesGuard.
 */
@Controller('doctors/:doctorId/schedules')
export class SchedulesController {
  constructor(private readonly schedulesService: SchedulesService) {}

  @Get()
  list(
    @Param('doctorId', ParseUUIDPipe) doctorId: string,
  ): Promise<Schedule[]> {
    return this.schedulesService.listForDoctor(doctorId);
  }

  @Post()
  @UseGuards(DoctorOwnershipGuard)
  @HttpCode(HttpStatus.CREATED)
  create(
    @Param('doctorId', ParseUUIDPipe) doctorId: string,
    @Body() dto: CreateScheduleDto,
  ): Promise<Schedule> {
    return this.schedulesService.create(doctorId, dto);
  }

  @Patch(':id')
  @UseGuards(DoctorOwnershipGuard)
  update(
    @Param('doctorId', ParseUUIDPipe) doctorId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateScheduleDto,
  ): Promise<Schedule> {
    return this.schedulesService.update(doctorId, id, dto);
  }

  @Delete(':id')
  @UseGuards(DoctorOwnershipGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('doctorId', ParseUUIDPipe) doctorId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.schedulesService.remove(doctorId, id);
  }
}
