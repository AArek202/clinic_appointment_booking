import { Body, Controller, Post } from '@nestjs/common';
import { AuthUser } from '../auth/auth-user.interface';
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
}
