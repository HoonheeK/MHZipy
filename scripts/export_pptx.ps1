param(
    [Parameter(Mandatory=$true)][string]$SourcePath,
    [Parameter(Mandatory=$true)][string]$TargetPath
)

# Resolve paths to absolute paths
$SourcePath = Resolve-Path -Path $SourcePath -ErrorAction Stop
$TargetPath = [System.IO.Path]::GetFullPath($TargetPath)

try {
    # 32 = ppSaveAsPDF
    $ppSaveAsPDF = 32

    $ppt = New-Object -ComObject PowerPoint.Application
    
    # Hide the application window
    # $ppt.Visible = [Microsoft.Office.Core.MsoTriState]::msoFalse
    
    # Open the presentation (ReadOnly=True, Untitled=False, WithWindow=False)
    $presentation = $ppt.Presentations.Open($SourcePath, $true, $false, $false)
    
    # Save as PDF
    $presentation.SaveAs($TargetPath, $ppSaveAsPDF)
    
    # Close presentation
    $presentation.Close()
}
catch {
    Write-Error "Failed to convert PPTX to PDF: $_"
    exit 1
}
finally {
    if ($ppt) {
        $ppt.Quit()
        [System.Runtime.Interopservices.Marshal]::ReleaseComObject($ppt) | Out-Null
        [System.GC]::Collect()
        [System.GC]::WaitForPendingFinalizers()
    }
}
