import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { DoctorOwnershipGuard } from '../auth/guards/doctor-ownership.guard';
import { Block } from './block.entity';
import { BlocksService } from './blocks.service';
import { CreateBlockDto } from './dto/create-block.dto';

/**
 * There is no PATCH here, unlike schedules. docs/API.md lists GET, POST and
 * DELETE only: a block is a statement about one specific period, so correcting
 * it means deleting the wrong one and adding the right one.
 */
@Controller('doctors/:doctorId/blocks')
export class BlocksController {
  constructor(private readonly blocksService: BlocksService) {}

  @Get()
  list(@Param('doctorId', ParseUUIDPipe) doctorId: string): Promise<Block[]> {
    return this.blocksService.listForDoctor(doctorId);
  }

  @Post()
  @UseGuards(DoctorOwnershipGuard)
  @HttpCode(HttpStatus.CREATED)
  create(
    @Param('doctorId', ParseUUIDPipe) doctorId: string,
    @Body() dto: CreateBlockDto,
  ): Promise<Block> {
    return this.blocksService.create(doctorId, dto);
  }

  @Delete(':id')
  @UseGuards(DoctorOwnershipGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('doctorId', ParseUUIDPipe) doctorId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.blocksService.remove(doctorId, id);
  }
}
