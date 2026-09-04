import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../common/enums/role.enum';
import { DoctorsService } from './doctors.service';
import { CreateDoctorDto } from './dto/create-doctor.dto';

@Controller('doctors')
export class DoctorsController {
  constructor(private readonly doctors: DoctorsService) {}

  @Roles(UserRole.Admin)
  @Post()
  async create(@Body() dto: CreateDoctorDto) {
    const doctor = await this.doctors.createDoctor(dto);
    return {
      id: doctor.id,
      specialization: doctor.specialization,
      email: dto.email.trim().toLowerCase(),
    };
  }

  @Get()
  async list() {
    const doctors = await this.doctors.findAll();
    return doctors.map((doctor) => ({
      id: doctor.id,
      specialization: doctor.specialization,
      firstName: doctor.user?.firstName,
      lastName: doctor.user?.lastName,
    }));
  }

  @Get(':id')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    const doctor = await this.doctors.findById(id);
    return {
      id: doctor.id,
      firstName: doctor.user?.firstName,
      lastName: doctor.user?.lastName,
      specialization: doctor.specialization,
      achievements: doctor.achievements,
    };
  }
}
