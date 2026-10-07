// 弹窗四边 + 四角拖拽调大小手柄, 配合 useResizable 使用; 双击任一方向复位默认尺寸
export function RzHandles({ start, reset }) {
  const sizes = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']
  return (
    <>
      {sizes.map((dir) => (
        <i key={dir} className={'rz rz-' + dir}
          onMouseDown={(e) => start(e, dir)}
          onDoubleClick={reset}
          title="拖动调整大小，双击复位"></i>
      ))}
    </>
  )
}

