import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Agent, AgentSchema, Match, MatchSchema } from '../database/schemas';
import { ManagedAgentController } from './managed-agent.controller';
import { ManagedAgentService } from './managed-agent.service';
import { ManagedBrainController } from './managed-brain.controller';
import { ManagedBrainService } from './managed-brain.service';
import { PodClient } from './pod.client';
import { SaidModule } from '../said/said.module';
import { SettlementModule } from '../settlement/settlement.module';
import { RelayerModule } from '../relayer/relayer.module';

@Module({
  imports: [
    SaidModule,
    SettlementModule,
    RelayerModule,
    MongooseModule.forFeature([
      { name: Agent.name, schema: AgentSchema },
      { name: Match.name, schema: MatchSchema },
    ]),
    // ConfigService comes from @Global() ConfigModule
  ],
  controllers: [ManagedAgentController, ManagedBrainController],
  providers: [ManagedAgentService, ManagedBrainService, PodClient],
  exports: [ManagedAgentService, PodClient],
})
export class ManagedAgentModule {}
