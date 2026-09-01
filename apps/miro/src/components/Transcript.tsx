import type { Ref } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { Block } from "@miro/ui-model";
import { UserBlock } from "./blocks/UserBlock";
import { AssistantBlock } from "./blocks/AssistantBlock";
import { ActivityBlock } from "./blocks/ActivityBlock";
import { PlanCard } from "./blocks/PlanCard";
import { OperationCard } from "./blocks/OperationCard";
import { NoticeBlock } from "./blocks/NoticeBlock";

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case "user":
      return <UserBlock text={block.text} />;
    case "assistant":
      return <AssistantBlock text={block.text} streaming={block.streaming} />;
    case "activity":
      return <ActivityBlock node={block.node} />;
    case "plan":
      return <PlanCard plan={block.plan} decision={block.decision} />;
    case "operation":
      return <OperationCard plan={block.plan} phase={block.phase} result={block.result} />;
    case "notice":
      return <NoticeBlock level={block.level} text={block.text} />;
  }
}

/** Sticky to the bottom until the reader scrolls away; ScrollBox re-engages stickiness on its own
 * once they scroll back down. Pattern from opencode's session scrollbox (MIT). */
export function Transcript({ blocks, scrollRef }: { blocks: Block[]; scrollRef: Ref<ScrollBoxRenderable> }) {
  return (
    <scrollbox ref={scrollRef} flexGrow={1} stickyScroll stickyStart="bottom" paddingLeft={1} paddingRight={1}>
      <box flexDirection="column" gap={1} paddingTop={1} paddingBottom={1}>
        {blocks.map((block) => (
          <BlockView key={`${block.kind}:${block.id}`} block={block} />
        ))}
      </box>
    </scrollbox>
  );
}
