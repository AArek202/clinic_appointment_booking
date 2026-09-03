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
} from '@nestjs/common';
import type { AuthUser } from '../auth/auth-user.interface';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../common/enums/role.enum';
import { JoinWaitingListDto } from './dto/join-waiting-list.dto';
import {
  WaitingListEntryView,
  WaitingListService,
} from './waiting-list.service';

function present(view: WaitingListEntryView) {
  return {
    id: view.entry.id,
    doctorId: view.entry.doctorId,
    slotStartAt: view.entry.slotStartAt.toISOString(),
    slotEndAt: view.entry.slotEndAt.toISOString(),
    status: view.entry.status,
    position: view.position,
  };
}

@Roles(UserRole.Patient)
@Controller('waiting-list')
export class WaitingListController {
  constructor(private readonly waitingList: WaitingListService) {}

  @Post()
  async join(@CurrentUser() user: AuthUser, @Body() dto: JoinWaitingListDto) {
    return present(await this.waitingList.join(user.patientId!, dto));
  }

  @Get('me')
  async mine(@CurrentUser() user: AuthUser) {
    const views = await this.waitingList.listForPatient(user.patientId!);
    return views.map(present);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async leave(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.waitingList.leave(id, user.patientId!);
  }
}
