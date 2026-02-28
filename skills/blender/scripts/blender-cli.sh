#!/bin/bash
# Blender MCP CLI helper
# Usage: blender-cli.sh <command> [args...]

SERVER="http://localhost:8000"

invoke() {
    curl -s -X POST "$SERVER/mcp/invoke/$1" \
        -H "Content-Type: application/json" \
        -d "$2" | python3 -m json.tool 2>/dev/null || echo "Error calling $1"
}

case "$1" in
    status)
        curl -s "$SERVER/docs" > /dev/null 2>&1 && echo "✓ Blender MCP running on $SERVER" || echo "✗ Blender MCP not running"
        ;;
    tools)
        curl -s "$SERVER/mcp/list_tools" | python3 -m json.tool
        ;;
    create)
        TYPE="${2:-CUBE}"
        NAME="${3:-Object}"
        X="${4:-0}" Y="${5:-0}" Z="${6:-0}"
        SIZE="${7:-1}"
        invoke "create_object" "{\"type\":\"$TYPE\",\"name\":\"$NAME\",\"location\":[$X,$Y,$Z],\"size\":$SIZE}"
        ;;
    material)
        NAME="$2" R="$3" G="$4" B="$5" A="${6:-1}"
        invoke "create_material" "{\"name\":\"$NAME\",\"color\":[$R,$G,$B,$A]}"
        ;;
    assign)
        OBJ="$2" MAT="$3"
        invoke "assign_material" "{\"object_name\":\"$OBJ\",\"material_name\":\"$MAT\"}"
        ;;
    render)
        FILE="${2:-/tmp/render.png}" W="${3:-512}" H="${4:-512}"
        invoke "set_render_settings" "{\"resolution_x\":$W,\"resolution_y\":$H,\"engine\":\"EEVEE\",\"samples\":64}"
        invoke "render_image" "{\"filepath\":\"$FILE\"}"
        echo "Rendered to $FILE"
        ;;
    clear)
        invoke "clear_scene" "{}"
        ;;
    info)
        invoke "get_scene_info" "{}"
        ;;
    list)
        invoke "list_objects" "{}"
        ;;
    *)
        echo "Blender MCP CLI"
        echo "Usage: $0 <command> [args...]"
        echo ""
        echo "Commands:"
        echo "  status              Check if MCP server is running"
        echo "  tools               List all available tools"
        echo "  create TYPE NAME X Y Z SIZE"
        echo "  material NAME R G B [A]"
        echo "  assign OBJ_NAME MAT_NAME"
        echo "  render [FILE] [W] [H]"
        echo "  clear               Clear entire scene"
        echo "  info                Get scene info"
        echo "  list                List all objects"
        ;;
esac
