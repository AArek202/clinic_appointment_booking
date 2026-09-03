import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import type { AuthUser } from '../auth/auth-user.interface';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../common/enums/role.enum';
import { AppointmentsService } from './appointments.service';
import { CreateAppointmentDto } from './dto/create-appointment.dto';

@Controller()
export class AppointmentsController {
  constructor(private readonly appointments: AppointmentsService) {}

  @Roles(UserRole.Patient)
  @Post('appointments')
  async create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateAppointmentDto,
  ) {
    const appointment = await this.appointments.book(
      user.patientId!,
      dto.doctorId,
      dto.startAt,
    );
    return {
      id: appointment.id,
      doctorId: appointment.doctorId,
      startAt: appointment.startAt.toISOString(),
      endAt: appointment.endAt.toISOString(),
      status: appointment.status,
      createdFrom: appointment.createdFrom,
    };
  }

  @Roles(UserRole.Patient)
  @Get('appointments/me')
  async mine(@CurrentUser() user: AuthUser) {
    const rows = await this.appointments.listForPatient(user.patientId!);
    return rows.map((appointment) => ({
      id: appointment.id,
      doctorId: appointment.doctorId,
      startAt: appointment.startAt.toISOString(),
      endAt: appointment.endAt.toISOString(),
      status: appointment.status,
    }));
  }

  @Post('appointments/:id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const appointment = await this.appointments.cancel(id, user);
    return {
      id: appointment.id,
      status: appointment.status,
      cancelledAt: appointment.cancelledAt?.toISOString() ?? null,
    };
  }
}
