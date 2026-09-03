import { Type } from 'class-transformer';
import { IsDate, IsOptional, IsUUID } from 'class-validator';

export class JoinWaitingListDto {
  @IsUUID()
  doctorId!: string;

  @Type(() => Date)
  @IsDate()
  slotStartAt!: Date;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  expiresAt?: Date;
}
