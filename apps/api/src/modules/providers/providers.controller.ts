import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { CreateProviderDto } from './dto/create-provider.dto';
import { UpdateProviderStatusDto } from './dto/update-provider-status.dto';
import { UpdateProviderDto } from './dto/update-provider.dto';
import { ProvidersService } from './providers.service';

@Controller('providers')
export class ProvidersController {
  constructor(@Inject(ProvidersService) private readonly providersService: ProvidersService) {}

  @Post()
  createProvider(@Body() dto: CreateProviderDto) {
    return this.providersService.createProvider(dto);
  }

  @Get()
  listProviders(
    @Query('status') status?: string,
    @Query('city') city?: string,
    @Query('categoryId') categoryId?: string,
  ) {
    return this.providersService.listProviders({ status, city, categoryId });
  }

  @Get(':providerId/requests')
  listMatchingRequests(
    @Param('providerId') providerId: string,
    @Query('categoryId') categoryId?: string,
    @Query('city') city?: string,
    @Query('district') district?: string,
    @Query('minQualityScore') minQualityScore?: string,
    @Query('qualityLabel') qualityLabel?: string,
    @Query('urgency') urgency?: string,
  ) {
    return this.providersService.listMatchingRequests(providerId, {
      categoryId,
      city,
      district,
      minQualityScore,
      qualityLabel,
      urgency,
    });
  }

  @Get(':providerId/requests/:requestId')
  getMatchingRequest(@Param('providerId') providerId: string, @Param('requestId') requestId: string) {
    return this.providersService.getMatchingRequest(providerId, requestId);
  }

  @Get(':id')
  getProvider(@Param('id') id: string) {
    return this.providersService.getProvider(id);
  }

  @Patch(':id')
  updateProvider(@Param('id') id: string, @Body() dto: UpdateProviderDto) {
    return this.providersService.updateProvider(id, dto);
  }

  @Patch(':id/status')
  updateProviderStatus(@Param('id') id: string, @Body() dto: UpdateProviderStatusDto) {
    return this.providersService.updateProviderStatus(id, dto);
  }
}
