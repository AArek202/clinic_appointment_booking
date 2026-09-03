import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { AvailabilityQueryDto } from './dto/availability-query.dto';
import { AvailabilityService } from './availability.service';

@Controller('doctors/:doctorId/availability')
export class AvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  /**
   * Readable by any authenticated user: patients need it to book, and it
   * exposes no personal data -- only free times.
   */
  @Get()
  async list(
    @Param('doctorId', ParseUUIDPipe) doctorId: string,
    @Query() query: AvailabilityQueryDto,
  ) {
    const slots = await this.availability.listSlots(
      doctorId,
      query.from,
      query.to,
    );
    return slots.map((slot) => ({
      startAt: slot.startAt.toISOString(),
      endAt: slot.endAt.toISOString(),
    }));
  }
}
