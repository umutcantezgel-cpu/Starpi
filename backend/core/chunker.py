import re
from typing import List, Dict, Any

def chunk_markdown(markdown_text: str, max_chunk_chars: int = 1500) -> List[Dict[str, Any]]:
    """
    Splits structured Markdown text by section headers (## or ###) into logical semantic chunks.
    Ensures that headers and sub-contexts are preserved.
    """
    if not markdown_text or not markdown_text.strip():
        return []

    # Match markdown headers starting with #, ##, ###, ####
    header_pattern = re.compile(r'^(#{1,4}\s+.+)$', re.MULTILINE)
    
    sections: List[Dict[str, Any]] = []
    lines = markdown_text.split("\n")
    
    current_heading = "Allgemein"
    current_lines = []
    section_index = 0
    
    for line in lines:
        if header_pattern.match(line):
            # If we already have accumulated lines, flush current section
            if current_lines:
                chunk_text = "\n".join(current_lines).strip()
                if chunk_text:
                    sections.append({
                        "section_index": section_index,
                        "heading": current_heading,
                        "markdown_content": chunk_text,
                        "token_count": len(chunk_text.split())
                    })
                    section_index += 1
                current_lines = []
            current_heading = line.strip()
            current_lines.append(line)
        else:
            current_lines.append(line)
            
            # If a single section without headers becomes too long, split it cleanly
            if len("\n".join(current_lines)) > max_chunk_chars:
                chunk_text = "\n".join(current_lines).strip()
                sections.append({
                    "section_index": section_index,
                    "heading": current_heading,
                    "markdown_content": chunk_text,
                    "token_count": len(chunk_text.split())
                })
                section_index += 1
                current_lines = []
                
    if current_lines:
        chunk_text = "\n".join(current_lines).strip()
        if chunk_text:
            sections.append({
                "section_index": section_index,
                "heading": current_heading,
                "markdown_content": chunk_text,
                "token_count": len(chunk_text.split())
            })
            
    return sections
