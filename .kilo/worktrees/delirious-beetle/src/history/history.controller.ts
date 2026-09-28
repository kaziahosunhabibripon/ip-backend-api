import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Query,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrorResponses } from '../common/decorators/api-error-responses.decorator';
import { RequiredUser } from '../common/decorators/current-user.decorator';
import type { CheckHistory, Paginated, User } from '../contracts';
import { HistoryQueryDto, PaginatedHistoryDto } from './dto/history.dto';
import { HistoryService } from './history.service';

@ApiTags('history')
@ApiCookieAuth()
@Controller('history')
export class HistoryController {
  constructor(private readonly history: HistoryService) {}

  @Get()
  @ApiOperation({
    summary: 'List saved checks',
    description:
      'The signed-in user’s saved lookups with search, type and date filters, sorting and paging. Open one with `GET /check/{id}`.',
  })
  @ApiOkResponse({ type: PaginatedHistoryDto })
  @ApiErrorResponses(401, 422)
  list(
    @RequiredUser() user: User,
    @Query() query: HistoryQueryDto,
  ): Promise<Paginated<CheckHistory>> {
    return this.history.list(user.id, query);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete one saved check' })
  @ApiNoContentResponse()
  @ApiErrorResponses(401, 404)
  remove(@RequiredUser() user: User, @Param('id') id: string): Promise<void> {
    return this.history.remove(user.id, id);
  }

  @Delete()
  @HttpCode(204)
  @ApiOperation({
    summary: 'Delete the whole history',
    description: 'Cannot be undone. Usage counts and quota are unaffected.',
  })
  @ApiNoContentResponse()
  @ApiErrorResponses(401)
  clear(@RequiredUser() user: User): Promise<void> {
    return this.history.clear(user.id);
  }
}
