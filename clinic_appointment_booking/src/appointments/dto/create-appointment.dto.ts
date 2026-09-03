import { Type } from 'class-transformer';
import { IsDate, IsUUID } from 'class-validator';

export class CreateAppointmentDto {
  @IsUUID()
  doctorId!: string;

  @Type(() => Date)
  @IsDate()
  startAt!: Date;
}
