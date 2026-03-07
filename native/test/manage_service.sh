#!/bin/bash
#
# Service management script for sv_service_standalone
# Usage: bash manage_service.sh {build|install|start|stop|status|logs|uninstall}
#

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BINARY_PATH="$SCRIPT_DIR/sv_service_standalone"
SERVICE_FILE="$SCRIPT_DIR/sv_service_standalone.service"
SERVICE_NAME="sv_service_standalone"
SYSTEMD_PATH="/etc/systemd/system/$SERVICE_NAME.service"
LOG_DIR="/var/log/sv_service"

set -e

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${BLUE}[INFO]${NC} $*"
}

log_success() {
    echo -e "${GREEN}[✓]${NC} $*"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $*"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $*"
}

# ─────────────────────────────────────────────────────────────────
# COMMAND: BUILD
# ─────────────────────────────────────────────────────────────────
cmd_build() {
    log_info "Building $SERVICE_NAME..."
    
    # Check MKL
    if [ ! -f "/opt/intel/oneapi/mkl/latest/include/mkl_dfti.h" ]; then
        log_error "Intel MKL not found!"
        log_info "Install with: sudo apt install intel-oneapi-mkl-devel"
        exit 1
    fi
    
    # Run build script
    bash "$SCRIPT_DIR/build_standalone.sh" "$BINARY_PATH"
    
    log_success "Binary built: $BINARY_PATH"
}

# ─────────────────────────────────────────────────────────────────
# COMMAND: INSTALL
# ─────────────────────────────────────────────────────────────────
cmd_install() {
    log_info "Installing systemd service..."
    
    # Build if not exists
    if [ ! -f "$BINARY_PATH" ]; then
        log_warning "Binary not found, building..."
        cmd_build
    fi
    
    # Create log directory
    log_info "Creating log directory..."
    sudo mkdir -p "$LOG_DIR"
    sudo chmod 755 "$LOG_DIR"
    
    # Copy service file
    log_info "Copying service file..."
    sudo cp "$SERVICE_FILE" "$SYSTEMD_PATH"
    
    # Reload systemd
    log_info "Reloading systemd daemon..."
    sudo systemctl daemon-reload
    
    log_success "Service installed: $SYSTEMD_PATH"
    log_info ""
    log_info "Next steps:"
    log_info "  1. Verify configuration: sudo nano $SYSTEMD_PATH"
    log_info "  2. Set your interface index in ExecStart line"
    log_info "  3. Start service: sudo systemctl start $SERVICE_NAME"
    log_info "  4. Check status: systemctl status $SERVICE_NAME"
}

# ─────────────────────────────────────────────────────────────────
# COMMAND: START
# ─────────────────────────────────────────────────────────────────
cmd_start() {
    log_info "Starting $SERVICE_NAME..."
    
    if ! sudo systemctl is-active --quiet "$SERVICE_NAME"; then
        sudo systemctl start "$SERVICE_NAME"
        sleep 1
    fi
    
    if sudo systemctl is-active --quiet "$SERVICE_NAME"; then
        log_success "Service started"
        cmd_status
    else
        log_error "Failed to start service"
        cmd_logs --last 20
        exit 1
    fi
}

# ─────────────────────────────────────────────────────────────────
# COMMAND: STOP
# ─────────────────────────────────────────────────────────────────
cmd_stop() {
    log_info "Stopping $SERVICE_NAME..."
    
    if sudo systemctl is-active --quiet "$SERVICE_NAME"; then
        sudo systemctl stop "$SERVICE_NAME"
        sleep 1
        log_success "Service stopped"
    else
        log_warning "Service not running"
    fi
}

# ─────────────────────────────────────────────────────────────────
# COMMAND: STATUS
# ─────────────────────────────────────────────────────────────────
cmd_status() {
    echo ""
    sudo systemctl status "$SERVICE_NAME" --no-pager
    echo ""
    
    # CPU/Memory stats
    local pid=$(pgrep sv_service_standalone || true)
    if [ -n "$pid" ]; then
        log_info "Process stats for PID $pid:"
        ps aux | grep "$pid" | grep -v grep || true
    fi
}

# ─────────────────────────────────────────────────────────────────
# COMMAND: LOGS
# ─────────────────────────────────────────────────────────────────
cmd_logs() {
    local follow=false
    local last_lines=50
    
    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            -f|--follow) follow=true; shift ;;
            --last) last_lines="$2"; shift 2 ;;
            *) shift ;;
        esac
    done
    
    if [ "$follow" = true ]; then
        log_info "Following systemd logs (Ctrl+C to stop)..."
        echo ""
        sudo journalctl -u "$SERVICE_NAME" -f
    else
        log_info "Last $last_lines lines of systemd logs:"
        echo ""
        sudo journalctl -u "$SERVICE_NAME" -n "$last_lines" --no-pager
    fi
}

# ─────────────────────────────────────────────────────────────────
# COMMAND: RESTART
# ─────────────────────────────────────────────────────────────────
cmd_restart() {
    log_info "Restarting $SERVICE_NAME..."
    sudo systemctl restart "$SERVICE_NAME"
    sleep 1
    cmd_status
}

# ─────────────────────────────────────────────────────────────────
# COMMAND: ENABLE
# ─────────────────────────────────────────────────────────────────
cmd_enable() {
    log_info "Enabling auto-start on boot..."
    sudo systemctl enable "$SERVICE_NAME"
    log_success "Enabled: $SERVICE_NAME will start on boot"
}

# ─────────────────────────────────────────────────────────────────
# COMMAND: DISABLE
# ─────────────────────────────────────────────────────────────────
cmd_disable() {
    log_info "Disabling auto-start..."
    sudo systemctl disable "$SERVICE_NAME"
    log_success "Disabled: $SERVICE_NAME will NOT start on boot"
}

# ─────────────────────────────────────────────────────────────────
# COMMAND: UNINSTALL
# ─────────────────────────────────────────────────────────────────
cmd_uninstall() {
    log_warning "This will UNINSTALL the systemd service"
    read -p "Are you sure? (yes/no) " -n 3 -r
    echo
    if [[ $REPLY =~ ^[Yy][Ee][Ss]$ ]]; then
        log_info "Uninstalling..."
        
        # Stop if running
        if sudo systemctl is-active --quiet "$SERVICE_NAME"; then
            log_info "Stopping service..."
            sudo systemctl stop "$SERVICE_NAME"
        fi
        
        # Disable auto-start
        sudo systemctl disable "$SERVICE_NAME" 2>/dev/null || true
        
        # Remove service file
        if [ -f "$SYSTEMD_PATH" ]; then
            log_info "Removing $SYSTEMD_PATH..."
            sudo rm "$SYSTEMD_PATH"
        fi
        
        # Reload systemd
        sudo systemctl daemon-reload
        
        log_success "Service uninstalled"
    else
        log_info "Uninstall cancelled"
    fi
}

# ─────────────────────────────────────────────────────────────────
# COMMAND: TEST (run foreground)
# ─────────────────────────────────────────────────────────────────
cmd_test() {
    log_info "Running $SERVICE_NAME in foreground (test mode)..."
    log_info "Interface: 0 (adjust as needed)"
    log_info "Press Ctrl+C to stop"
    echo ""
    
    "$BINARY_PATH" 0
}

# ─────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────
cmd_help() {
    cat << EOF
$SERVICE_NAME Management Script

USAGE: $(basename "$0") {COMMAND}

COMMANDS:
  
  build              Build the standalone binary
  install            Install as systemd service
  start              Start the service
  stop               Stop the service
  restart            Restart the service
  status             Show service status and stats
  logs               Show service logs
    --follow, -f     Follow logs in real-time
    --last N         Show last N lines (default: 50)
  
  enable             Enable auto-start on boot
  disable            Disable auto-start on boot
  
  test               Run in foreground (test mode)
  uninstall          Uninstall systemd service
  
  help               Show this help

EXAMPLES:

  # Build and install
  $(basename "$0") build
  $(basename "$0") install
  
  # Start service
  $(basename "$0") start
  
  # Follow logs
  $(basename "$0") logs -f
  
  # Check status
  $(basename "$0") status
  
  # Test before installing
  $(basename "$0") test

  # Full setup (build→install→start)
  $(basename "$0") build && $(basename "$0") install && $(basename "$0") start

EOF
}

# ─────────────────────────────────────────────────────────────────
# Parse and dispatch command
# ─────────────────────────────────────────────────────────────────

if [ $# -eq 0 ]; then
    cmd_help
    exit 0
fi

case "$1" in
    build)      cmd_build ;;
    install)    cmd_install ;;
    start)      cmd_start ;;
    stop)       cmd_stop ;;
    restart)    cmd_restart ;;
    status)     cmd_status ;;
    logs)       shift; cmd_logs "$@" ;;
    enable)     cmd_enable ;;
    disable)    cmd_disable ;;
    test)       cmd_test ;;
    uninstall)  cmd_uninstall ;;
    help|--help|-h) cmd_help ;;
    *)          
        log_error "Unknown command: $1"
        echo ""
        cmd_help
        exit 1
        ;;
esac
