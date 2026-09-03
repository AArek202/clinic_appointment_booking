import {
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateDoctorDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  firstName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  lastName!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  specialization!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  achievements?: string;
}
