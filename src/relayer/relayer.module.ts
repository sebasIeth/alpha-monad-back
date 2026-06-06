import { Module } from '@nestjs/common';
import { RelayerService } from './relayer.service';

@Module({
  providers: [RelayerService],
  exports: [RelayerService],
})
export class RelayerModule {}
